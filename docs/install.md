# Installing BMM

BMM is one container plus a Postgres database. Both installs below bring
their own Postgres; you can point either at one you already run.

## Kubernetes with Helm

The chart is published as an OCI artifact next to the image.

```bash
helm install bmm oci://ghcr.io/baakhoff/charts/bmm --version 0.2.0 \
  --namespace bmm --create-namespace \
  --set ingress.enabled=true \
  --set ingress.host=bmm.example.com
```

What you get: the BMM Deployment with a volume for uploaded media, a
single-replica Postgres StatefulSet on your default StorageClass, a Service, an Ingress on your default
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
# set POSTGRES_PASSWORD (letters and digits only) and BMM_SECRET_KEY in .env
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

Three things, and you need all three to restore:

1. **The database.** Everything BMM knows.

   ```bash
   kubectl -n bmm exec bmm-postgres-0 -- pg_dump -U bmm bmm > bmm.sql
   ```

2. **The media volume**, mounted at `/data`: the uploaded images.
3. **The secret key.** It encrypts the networks' credentials inside the
   database. A restored database with a different key works, but every
   account has to be connected again.

   ```bash
   kubectl -n bmm get secret bmm-key -o jsonpath='{.data.secret-key}' | base64 -d
   ```

   With Compose it is `BMM_SECRET_KEY` in your `.env`.

The chart marks the key Secret and the media volume to be kept when the
release is uninstalled, so a mistaken `helm uninstall` does not destroy
them. Delete them by hand when you really mean to.

## Upgrading

See [updating](updating.md): how to hear about releases, update by hand or
automatically, and roll back.
