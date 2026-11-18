# JB Security Guard — PHP and Python Distribution Validation

**Workflow:** .github/workflows/security-guard-runtime-distribution.yml  
**Scope:** clean consumer installation checks for Composer and Python distributions  
**Publication:** none; CI does not publish to Packagist, PyPI or another registry

## PHP / Composer

The PHP adapter is a standalone Composer library:

- Package: jb/security-guard-php
- Manifest version: inferred from VCS tags; no hard-coded version field
- Minimum runtime: PHP 8.2
- Required third-party runtime dependencies: none
- Laravel integration remains optional and uses host-provided Illuminate packages.

The workflow validates composer.json strictly, creates a ZIP archive through composer archive with a temporary COMPOSER_ROOT_VERSION of 0.1.0, extracts it into a clean directory, then installs that extracted package through a Composer path repository with symlink=false and a test-only version override. It verifies PSR-4 autoloading for Core v1, the authenticated client, and upload-inspection interfaces/service. The archive excludes test fixtures and vendor content.

The library manifest intentionally omits a fixed version so a real release can infer its version from a VCS tag. The temporary 0.1.0 override is only for this local CI consumer; it is not written into the package manifest.

## Python / wheel and source distribution

The Python adapter is independently packageable through PEP 517 / setuptools:

- Package: jb-security-guard
- Version: 0.1.0
- Minimum runtime: Python 3.11
- Build frontend: build

The workflow creates both a wheel and a source distribution. The default python -m build flow builds the wheel from the generated sdist, which checks that the source archive contains the files required to build. The wheel and sdist are then installed in separate fresh virtual environments, from outside the repository working directory, with no dependency resolution from a package index during the package install step.

## Certification boundary

A successful job confirms that the current source can produce and install its declared Composer/Python artifacts in clean local consumers on the tested runner. It does not publish a release, prove compatibility with every supported Laravel/Django/FastAPI version, certify a production scanner/storage provider, or establish universal feature parity among Security Guard runtimes.

No production credentials, live services, paid tooling, deployment or registry publication are used.
