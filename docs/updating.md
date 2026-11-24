# Updates, alerts and security

## How BMM is released

| Tag      | What it is                                            | Use it for                          |
| -------- | ----------------------------------------------------- | ----------------------------------- |
| `1.2.3`  | A release. Never changes once published.              | Anything you intend to keep.        |
| `1.2`    | The newest patch of a minor line.                     | Following patches without thinking. |
| `latest` | The newest release.                                   | Trying BMM out.                     |
| `edge`   | The tip of `main`, rebuilt on every merge and weekly. | Testing what comes next.            |

Every release publishes the image `ghcr.io/baakhoff/bmm`, for amd64 and
arm64, and the Helm chart `oci://ghcr.io/baakhoff/charts/bmm` at the same
version number.

## Finding out about a new version

Pick whichever fits how you work. They are not exclusive.

- **In BMM itself.** A banner appears for the admin when a newer release
  exists, with a link to what changed. `GET /api/v1/system/version` returns
  the same for scripts and monitoring. BMM asks GitHub's public API a few
  times a day and sends nothing about your instance. Turn it off with
  `BMM_UPDATE_CHECK=false` (`config.updateCheck=false` in Helm).
- **From GitHub.** On the repository page: Watch, Custom, Releases. Tick
  Security alerts as well to hear about advisories.
- **As a pull request in your GitOps repository.** Renovate reads the
  version you pinned and proposes the bump. This is the recommended way on
  a cluster: the pull request is the alert, and merging it is the upgrade.

## Updating on Kubernetes

Take a backup first (see [install](install.md#backups)). BMM migrates its
own database when the new version starts.

```bash
helm upgrade bmm oci://ghcr.io/baakhoff/charts/bmm --version <new version> --namespace bmm --reuse-values
```

### Flux, pinned, with Renovate proposing each bump

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: bmm
  namespace: bmm
spec:
  interval: 1h
  url: oci://ghcr.io/baakhoff/charts/bmm
  ref:
    tag: 0.1.0
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: bmm
  namespace: bmm
spec:
  interval: 1h
  chartRef:
    kind: OCIRepository
    name: bmm
  values:
    ingress:
      enabled: true
      host: bmm.example.com
```

Renovate's `flux` manager updates `ref.tag` on its own; no extra
configuration is needed.

### Flux, updating itself

Replace the pinned tag with a range and Flux installs each new release
within the interval, with no pull request:

```yaml
ref:
  semver: "0.x"
```

This trades review for convenience. A release that needs manual steps says
so in its notes, which nobody reads if the upgrade is automatic. Prefer the
pinned form for an instance you depend on.

## Updating with Docker Compose

```bash
cd bmm/deploy/compose
docker compose pull && docker compose up -d
```

The Compose file follows `latest` unless you set `BMM_TAG` in `.env`.
Pin a version there and let Renovate, or you, move it.

## Checking the result

After an upgrade, three things tell you it went well:

```bash
kubectl -n bmm rollout status deploy/bmm        # the new pod became ready
curl -fsS https://bmm.example.com/readyz        # it reaches its database
curl -fsS -H "Authorization: Bearer $BMM_TOKEN" https://bmm.example.com/api/v1/system/version
```

The last one returns the version now running. The pod only becomes ready
once the database migration has finished, so a failed migration shows up as
a rollout that never completes, with the reason in the pod's log, while the
old pod keeps serving.

## Rolling back

The database schema only moves forward. To go back to an older version,
restore the backup you took before upgrading, then install the old version.

## Security alerts

What the project itself does is in [SECURITY.md](../SECURITY.md): dependency
alerts, nightly image scans, code analysis and signed build provenance.

On your side, a cluster scanner such as Trivy Operator will report CVEs in
the BMM image you run like in any other. A fix is a new release; the nightly
scan here opens an issue the day a fixable high or critical CVE appears, so
the release normally follows quickly.

To check that an image really came from this repository:

```bash
gh attestation verify oci://ghcr.io/baakhoff/bmm:<version> --repo baakhoff/bmm
```
