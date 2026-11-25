# Security

## Reporting a vulnerability

Please report it privately: on this repository, open the **Security** tab and
press **Report a vulnerability**. Do not open a public issue for it.

You should hear back within a week. If the report is confirmed, a fix is
released and the advisory is published with credit to you, unless you prefer
otherwise.

## Supported versions

The latest release gets security fixes. BMM is young and moves quickly;
older releases are not patched.

## How this project watches its own supply chain

- **Dependencies.** GitHub's dependency alerts cover every npm package in the
  lockfile. Renovate opens a pull request for a vulnerable dependency as
  soon as a fix exists, and CI fails on any high or critical advisory.
- **The image.** Every published image is scanned with Trivy before the
  release is announced, and the published images are scanned again every
  night, since new CVEs are found in old images. A critical or high CVE that
  has a fix fails the scan and opens an issue here.
- **The code.** CodeQL analyses every push and pull request.
- **The build.** GitHub Actions are pinned to commits and base images to
  digests. Each image carries an SBOM and a signed build provenance
  attestation.

## Verifying an image

```bash
gh attestation verify oci://ghcr.io/baakhoff/bmm:0.2.0 --repo baakhoff/bmm
```

This proves the image was built by this repository's release workflow from
the tagged commit.
