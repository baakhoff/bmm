# Installing BMM

BMM is one container plus a Postgres database. Both installs below bring
their own Postgres; you can point either at one you already run.

## Kubernetes with Helm

The chart is published as an OCI artifact next to the image.

```bash
helm install bmm oci://ghcr.io/baakhoff/charts/bmm --version 0.1.2 \
  --namespace bmm --create-namespace \
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

### Flux and Argo CD

The chart works with both. A ready-to-copy Flux `OCIRepository` and
`HelmRelease`, pinned or self-updating, is in
[updating](updating.md#updating-on-kubernetes). With Argo CD, set
`postgresql.auth.password` or `postgresql.auth.existingSecret` as noted above.

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

See [updating](updating.md): how to hear about releases, update by hand or
automatically, and roll back.
