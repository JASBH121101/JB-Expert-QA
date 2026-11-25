import test from "node:test";
import assert from "node:assert/strict";
import {
  createSystemdHostServiceProfile,
  createWindowsHostServiceProfile,
  AutonomousExecutionServiceDeploymentError
} from "../src/agent/autonomous-execution-service-deployment.js";

function validSystemd(overrides = {}) {
  return {
    unitName: "jb-expert-qa.service",
    nodeExecutable: "/usr/bin/node",
    entryPoint: "/opt/jb-expert-qa/host-service.mjs",
    workingDirectory: "/opt/jb-expert-qa",
    storageDirectory: "/var/lib/jb-expert-qa",
    serviceUser: "jbexpertqa",
    serviceGroup: "jbexpertqa",
    ...overrides
  };
}

function validWindows(overrides = {}) {
  return {
    serviceId: "JBExpertQA",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    entryPoint: "C:\\Program Files\\JB Expert QA\\host-service.mjs",
    workingDirectory: "C:\\Program Files\\JB Expert QA",
    storageDirectory: "C:\\ProgramData\\JB Expert QA",
    ...overrides
  };
}

test("systemd profile renders an unprivileged, bounded, graceful service unit", () => {
  const profile = createSystemdHostServiceProfile(validSystemd());

  assert.equal(profile.platform, "linux-systemd");
  assert.equal(profile.fileName, "jb-expert-qa.service");
  assert.equal(profile.serviceUser, "jbexpertqa");
  assert.equal(profile.serviceGroup, "jbexpertqa");
  assert.equal(profile.restartPolicy, "on-failure");
  assert.equal(profile.stopTimeoutSeconds, 90);
  assert.match(profile.content, /^\[Unit\]/u);
  assert.match(profile.content, /User=jbexpertqa/u);
  assert.match(profile.content, /Group=jbexpertqa/u);
  assert.match(profile.content, /ExecStart=\/usr\/bin\/node \/opt\/jb-expert-qa\/host-service\.mjs/u);
  assert.match(profile.content, /Restart=on-failure/u);
  assert.match(profile.content, /StartLimitBurst=3/u);
  assert.match(profile.content, /KillSignal=SIGTERM/u);
  assert.match(profile.content, /TimeoutStopSec=90s/u);
  assert.match(profile.content, /NoNewPrivileges=true/u);
  assert.match(profile.content, /ProtectSystem=strict/u);
  assert.match(profile.content, /ReadWritePaths=\/var\/lib\/jb-expert-qa/u);
  assert.match(profile.content, /WantedBy=multi-user\.target/u);
  assert.doesNotMatch(profile.content, /sudo|systemctl enable|useradd|chmod/u);
});

test("systemd profile supports an explicit no-restart policy and bounded operator limits", () => {
  const profile = createSystemdHostServiceProfile(validSystemd({
    restartPolicy: "no",
    restartDelaySeconds: 25,
    startLimitBurst: 5,
    startLimitIntervalSeconds: 900,
    stopTimeoutSeconds: 120
  }));

  assert.equal(profile.restartPolicy, "no");
  assert.deepEqual(profile.restartLimit, { burst: 5, intervalSeconds: 900 });
  assert.match(profile.content, /Restart=no/u);
  assert.match(profile.content, /RestartSec=25s/u);
  assert.match(profile.content, /StartLimitIntervalSec=900s/u);
  assert.match(profile.content, /TimeoutStopSec=120s/u);
});

test("systemd profile rejects root identity, relative paths, injection and unsupported policy", () => {
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ serviceUser: "root" })),
    error => error instanceof AutonomousExecutionServiceDeploymentError && error.code === "INVALID_SERVICE_USER");
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ serviceGroup: "root" })),
    error => error.code === "INVALID_SERVICE_GROUP");
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ entryPoint: "host-service.mjs" })),
    error => error.code === "INVALID_PATH");
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ nodeExecutable: "/usr/bin/node;id" })),
    error => error.code === "INVALID_PATH");
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ restartPolicy: "always" })),
    error => error.code === "INVALID_RESTART_POLICY");
  assert.throws(() => createSystemdHostServiceProfile(validSystemd({ startLimitBurst: 0 })),
    error => error.code === "INVALID_START_LIMIT_BURST");
});

test("systemd profile rejects getters and unknown options without executing accessors", () => {
  const options = validSystemd();
  let called = false;
  Object.defineProperty(options, "entryPoint", {
    enumerable: true,
    get() {
      called = true;
      throw new Error("accessor must not run");
    }
  });
  assert.throws(() => createSystemdHostServiceProfile(options),
    error => error.code === "ACCESSOR_NOT_ALLOWED");
  assert.equal(called, false);
  assert.throws(() => createSystemdHostServiceProfile({ ...validSystemd(), sudo: true }),
    error => error.code === "UNSUPPORTED_OPTION");
});

test("Windows profile renders WinSW XML with quoted entry point and finite restart escalation", () => {
  const profile = createWindowsHostServiceProfile(validWindows({
    displayName: "JB Expert QA & Autonomous Host",
    description: "Local QA host <managed>",
    stopTimeoutSeconds: 75,
    restartDelaysSeconds: [15, 45]
  }));

  assert.equal(profile.platform, "windows-scm");
  assert.equal(profile.fileName, "JBExpertQA.xml");
  assert.equal(profile.wrapper, "WinSW XML (stable operator-supplied wrapper; independently verified)");
  assert.equal(profile.startMode, "Automatic");
  assert.equal(profile.delayedAutoStart, true);
  assert.equal(profile.restartExhaustionAction, "none");
  assert.deepEqual(profile.restartDelaysSeconds, [15, 45]);
  assert.match(profile.content, /<name>JB Expert QA &amp; Autonomous Host<\/name>/u);
  assert.match(profile.content, /<description>Local QA host &lt;managed&gt;<\/description>/u);
  assert.match(profile.content, /<executable>C:\\Program Files\\nodejs\\node\.exe<\/executable>/u);
  assert.match(profile.content, /<arguments>"C:\\Program Files\\JB Expert QA\\host-service\.mjs"<\/arguments>/u);
  assert.match(profile.content, /<stoptimeout>75sec<\/stoptimeout>/u);
  assert.match(profile.content, /<onfailure action="restart" delay="15 sec" \/>/u);
  assert.match(profile.content, /<onfailure action="restart" delay="45 sec" \/>/u);
  assert.match(profile.content, /<onfailure action="none" \/>/u);
  assert.match(profile.content, /JB_EXPERT_QA_STORAGE_DIRECTORY/u);
  assert.doesNotMatch(profile.content, /password|LocalSystem|sc\.exe create|powershell/u);
});

test("Windows Manual start mode defaults to no delayed automatic startup", () => {
  const profile = createWindowsHostServiceProfile(validWindows({ startMode: "Manual" }));
  assert.equal(profile.startMode, "Manual");
  assert.equal(profile.delayedAutoStart, false);
  assert.match(profile.content, /<startmode>Manual<\/startmode>/u);
  assert.doesNotMatch(profile.content, /delayedAutoStart/u);
});

test("Windows profile rejects malformed paths, unsafe service IDs and invalid retry policy", () => {
  assert.throws(() => createWindowsHostServiceProfile(validWindows({ serviceId: "JB Expert QA" })),
    error => error.code === "INVALID_SERVICE_ID");
  assert.throws(() => createWindowsHostServiceProfile(validWindows({ nodeExecutable: "node.exe" })),
    error => error.code === "INVALID_PATH");
  assert.throws(() => createWindowsHostServiceProfile(validWindows({ entryPoint: "C:\\Program Files\\host%PATH%.mjs" })),
    error => error.code === "INVALID_PATH");
  assert.throws(() => createWindowsHostServiceProfile(validWindows({ restartDelaysSeconds: [10, 0] })),
    error => error.code === "INVALID_RESTART_DELAYS");
  assert.throws(() => createWindowsHostServiceProfile(validWindows({
    startMode: "Manual",
    delayedAutoStart: true
  })), error => error.code === "INVALID_DELAYED_START");
});

test("Windows profile rejects expansion markers and accessor-backed retry arrays", () => {
  assert.throws(() => createWindowsHostServiceProfile(validWindows({
    displayName: "JB Expert QA %PATH%"
  })), error => error.code === "INVALID_DISPLAY_NAME");
  assert.throws(() => createWindowsHostServiceProfile(validWindows({
    description: "Service %SystemRoot%"
  })), error => error.code === "INVALID_DESCRIPTION");

  const delays = [10];
  let called = false;
  Object.defineProperty(delays, "0", {
    get() {
      called = true;
      return 10;
    }
  });
  assert.throws(() => createWindowsHostServiceProfile(validWindows({
    restartDelaysSeconds: delays
  })), error => error.code === "INVALID_RESTART_DELAYS");
  assert.equal(called, false);
});

test("Windows profile rejects accessors and unknown fields", () => {
  const options = validWindows();
  let called = false;
  Object.defineProperty(options, "entryPoint", {
    enumerable: true,
    get() {
      called = true;
      return "C:\\unsafe\\host.mjs";
    }
  });
  assert.throws(() => createWindowsHostServiceProfile(options),
    error => error.code === "ACCESSOR_NOT_ALLOWED");
  assert.equal(called, false);
  assert.throws(() => createWindowsHostServiceProfile({ ...validWindows(), password: "never" }),
    error => error.code === "UNSUPPORTED_OPTION");
});
