# Installing BMM

BMM is one container plus a Postgres database. Both installs below bring
their own Postgres; you can point either at one you already run.

## Kubernetes with Helm

The chart lives in this repository under `deploy/helm/bmm`.

```bash
git clone https://github.com/baakhoff/bmm.git
helm install bmm bmm/deploy/helm/bmm \
  --namespace bmm --create-namespace \
  --set image.tag=edge \
  --set ingress.enabled=true \
  --set ingress.host=bmm.example.com
```

What you get: the BMM Deployment, a single-replica Postgres StatefulSet on
your default StorageClass, a Service, an Ingress on your default
IngressClass, and NetworkPolicies that let only BMM reach the database.

Things you may need to change:

| Value                                             | When                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingress.className`                               | Your cluster has no default IngressClass.                                                                                                         |
| `ingress.tls.secretName`                          | Your ingress controller does not serve a default (wildcard) certificate. Add your cert-manager annotation under `ingress.annotations`.            |
| `postgresql.persistence.storageClass`             | You want a StorageClass other than the default.                                                                                                   |
| `postgresql.enabled=false` + `externalDatabase.*` | You run Postgres yourself.                                                                                                                        |
| `postgresql.auth.password` or `.existingSecret`   | You deploy with Argo CD or anything else that renders templates without cluster access. The generated password cannot be kept across syncs there. |
| `networkPolicy.ingressFrom`                       | You want only your ingress controller's namespace to reach BMM.                                                                                   |

Every value is documented in [`values.yaml`](../deploy/helm/bmm/values.yaml).

### Flux

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: bmm
  namespace: bmm
spec:
  interval: 1h
  url: https://github.com/baakhoff/bmm
  ref:
    branch: main
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: bmm
  namespace: bmm
spec:
  interval: 1h
  chart:
    spec:
      chart: deploy/helm/bmm
      sourceRef:
        kind: GitRepository
        name: bmm
  values:
    image:
      tag: edge
    ingress:
      enabled: true
      host: bmm.example.com
    oidc:
      issuer: https://id.example.com
      clientId: your-client-id
      existingSecret: bmm-oidc # a Secret with key client-secret
```

## Docker Compose

```bash
git clone https://github.com/baakhoff/bmm.git
cd bmm/deploy/compose
cp .env.example .env
# set POSTGRES_PASSWORD in .env (letters and digits only)
docker compose up -d
```

BMM listens on port 3000. Put a reverse proxy with TLS in front of it before
exposing it beyond your machine, and then set `BMM_PUBLIC_URL` and
`BMM_TRUST_PROXY=true` in `.env`.

## First run

Open the address and create the admin account. Until that is done, anyone who
can reach the instance can claim it, so either do it straight away or set a
setup token (`config.setupToken` in Helm, `BMM_SETUP_TOKEN` in Compose) before
the first start.

## Backups

Everything BMM knows is in its Postgres database. Back that up: a volume
snapshot, or

```bash
kubectl -n bmm exec bmm-postgres-0 -- pg_dump -U bmm bmm > bmm.sql
```

## Upgrading

Pull the new image and restart. BMM migrates its own database schema when it
starts. Take a backup first.
