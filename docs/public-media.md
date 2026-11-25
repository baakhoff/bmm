# Public media

Instagram does not accept image uploads. To publish, BMM hands Instagram a
link and Instagram downloads the image from it, from the public internet.
So one path of your instance has to be reachable from outside, even if
everything else stays inside your network. X is not affected; it takes
uploads.

## What gets exposed

Only `/public/`. It serves one kind of thing: a single image, as JPEG, under
a link that BMM signs and that stops working after two hours. A link is
made at the moment a post is published and given to nobody but the network.

Nothing else is behind that path: no sign-in, no API, no UI. Someone who
finds the public address learns only that something answers there; without
a valid signature every request gets "not found".

You then tell BMM the public address with `BMM_PUBLIC_MEDIA_URL`
(`publicMedia.url` in the Helm chart).

## Option 1: Cloudflare Tunnel

No inbound port, no public IP address. A small `cloudflared` process dials
out to Cloudflare, and Cloudflare forwards requests for one hostname back
through it. It needs a domain on Cloudflare; the free plan is enough.

1. In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, create a
   tunnel of type Cloudflared. Copy its token.
2. Add a public hostname to the tunnel, for example `media.example.com`,
   with the service `http://bmm.bmm.svc` (Helm: `http://<release>.<namespace>.svc`)
   or `http://bmm:3000` (Compose).
3. Restrict it to the one path: in the hostname's settings set **Path** to
   `^/public/`. Requests for anything else then never reach BMM.

With Helm:

```bash
kubectl -n bmm create secret generic bmm-tunnel --from-literal=token=<the tunnel token>
```

```yaml
publicMedia:
  url: https://media.example.com
  cloudflareTunnel:
    enabled: true
    tokenSecret: bmm-tunnel
```

With Compose, add a service next to BMM:

```yaml
tunnel:
  image: cloudflare/cloudflared:latest
  restart: unless-stopped
  command: tunnel --no-autoupdate run
  environment:
    TUNNEL_TOKEN: ${TUNNEL_TOKEN}
```

and set `BMM_PUBLIC_MEDIA_URL=https://media.example.com` in `.env`.

## Option 2: your own public ingress

If your cluster or reverse proxy is reachable from the internet, route one
public hostname's `/public/` path to BMM and nothing else.

With Helm, a second Ingress does exactly that:

```yaml
publicMedia:
  url: https://media.example.com
  ingress:
    enabled: true
    host: media.example.com
    # className and annotations for your public ingress controller
```

With a reverse proxy in front of Compose, forward only that path. In Caddy:

```
media.example.com {
  handle /public/* {
    reverse_proxy bmm:3000
  }
  respond 404
}
```

## Option 3: a relay on a machine you already have public

Any public web server that can proxy will do: forward `/public/` on a
hostname of that server to your BMM over a private link such as Tailscale or
WireGuard, and name that hostname in `BMM_PUBLIC_MEDIA_URL`. The Caddy
snippet above is the whole configuration, with `bmm:3000` replaced by BMM's
private address.

## Checking it

1. In BMM, **Networks** shows the public media address as configured.
2. From a machine outside your network (a phone on mobile data works):

   ```bash
   curl -i https://media.example.com/public/media/x/1/x.jpg
   ```

   A `404` with a JSON body `{"error":{"code":"not_found",...}}` is the
   right answer: the request reached BMM, which refused the made-up
   signature. A timeout, a certificate error or an HTML page from something
   else means the path is not routed to BMM yet.
3. The same check against any other path, such as `/api/v1/auth/status`,
   should not reach BMM.
