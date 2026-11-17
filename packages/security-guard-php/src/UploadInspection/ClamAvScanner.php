<?php

declare(strict_types=1);

namespace JB\SecurityGuard\UploadInspection;

final class ClamAvScanner implements MalwareScannerInterface
{
    private ?string $resolvedBinary = null;
    private ?string $cachedVersion = null;

    public function __construct(
        private readonly string $binary = 'clamscan',
        private readonly int $timeoutMs = 15000
    ) {
        if ($timeoutMs < 100 || $timeoutMs > 120000) {
            throw new \InvalidArgumentException('ClamAV timeout must be between 100 and 120000 milliseconds');
        }
    }

    public function scan(string $absolutePath): array
    {
        $unknown = ['verdict' => 'unknown', 'engine' => 'ClamAV', 'version' => 'unavailable'];
        $binary = $this->resolveBinary();
        if ($binary === null || !is_file($absolutePath) || !is_readable($absolutePath)) {
            return $unknown;
        }

        $version = $this->version($binary);
        if ($version === null) {
            return $unknown;
        }

        $result = $this->run([$binary, '--no-summary', '--stdout', $absolutePath], $this->timeoutMs);
        if ($result === null || $result['timedOut']) {
            return $unknown;
        }

        if ($result['exitCode'] === 0 && preg_match('/:\\s*OK(?:\\s|$)/m', $result['stdout']) === 1) {
            return ['verdict' => 'clean', 'engine' => 'ClamAV', 'version' => $version];
        }
        if ($result['exitCode'] === 1 && str_contains($result['stdout'], 'FOUND')) {
            return ['verdict' => 'malicious', 'engine' => 'ClamAV', 'version' => $version];
        }

        return $unknown;
    }

    private function resolveBinary(): ?string
    {
        if ($this->resolvedBinary !== null) {
            return $this->resolvedBinary;
        }

        if (str_contains($this->binary, DIRECTORY_SEPARATOR)) {
            return is_executable($this->binary) ? ($this->resolvedBinary = $this->binary) : null;
        }

        $path = getenv('PATH');
        if (!is_string($path) || $path === '') {
            return null;
        }

        foreach (explode(PATH_SEPARATOR, $path) as $directory) {
            if ($directory === '') continue;
            $candidate = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $this->binary;
            if (is_file($candidate) && is_executable($candidate)) {
                $this->resolvedBinary = $candidate;
                return $candidate;
            }
        }

        return null;
    }

    private function version(string $binary): ?string
    {
        if ($this->cachedVersion !== null) {
            return $this->cachedVersion;
        }

        $result = $this->run([$binary, '--version'], min(2000, $this->timeoutMs));
        if ($result === null || $result['timedOut'] || $result['exitCode'] !== 0) {
            return null;
        }

        if (preg_match('/^ClamAV\\s+([A-Za-z0-9._+-]{1,80})/mi', $result['stdout'], $matches) !== 1) {
            return null;
        }

        $this->cachedVersion = $matches[1];
        return $this->cachedVersion;
    }

    private function run(array $command, int $timeoutMs): ?array
    {
        if (!function_exists('proc_open')) {
            return null;
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $process = @proc_open($command, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            return null;
        }

        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $exitCode = -1;
        $timedOut = false;
        $deadline = microtime(true) + ($timeoutMs / 1000);

        while (true) {
            $stdout .= $this->readBounded($pipes[1], $stdout);
            $stderr .= $this->readBounded($pipes[2], $stderr);
            if (strlen($stdout) > 8192 || strlen($stderr) > 8192) {
                $timedOut = true;
                @proc_terminate($process, 15);
                break;
            }

            $status = proc_get_status($process);
            if (!($status['running'] ?? false)) {
                $exitCode = is_int($status['exitcode'] ?? null) ? $status['exitcode'] : -1;
                break;
            }
            if (microtime(true) >= $deadline) {
                $timedOut = true;
                @proc_terminate($process, 15);
                usleep(50000);
                $afterTerminate = proc_get_status($process);
                if ($afterTerminate['running'] ?? false) {
                    @proc_terminate($process, 9);
                }
                break;
            }
            usleep(10000);
        }

        $stdout .= $this->readBounded($pipes[1], $stdout);
        $stderr .= $this->readBounded($pipes[2], $stderr);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $closeCode = proc_close($process);
        if ($exitCode === -1 && $closeCode >= 0) {
            $exitCode = $closeCode;
        }

        return [
            'exitCode' => $exitCode,
            'stdout' => $stdout,
            'stderr' => $stderr,
            'timedOut' => $timedOut,
        ];
    }

    private function readBounded($stream, string $current): string
    {
        if (!is_resource($stream) || strlen($current) > 8192) {
            return '';
        }
        $remaining = 8193 - strlen($current);
        $chunk = fread($stream, min(2048, $remaining));
        return is_string($chunk) ? $chunk : '';
    }
}
