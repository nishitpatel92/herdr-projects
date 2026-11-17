# The web app through a reverse proxy (this fork's own)

Upstream Shepherdr shares its web app on the tailnet with `tailscale serve` ([web.md](web.md)). This fork adds a
second way in, **proxy mode**: the web app behind a reverse proxy you run yourself (for us, Caddy on a home server,
reached over the home LAN and WireGuard), with **each device paired once**. It is off unless you switch it on, and the
tailnet way keeps working beside it. How the fork is kept: [FORK.md](../FORK.md).

## Who gets in

- Only a **paired device**. A device pairs once with a one-time code (6 characters, works once, for 5 minutes) and then
  carries a long-lived cookie (400 days). Each device can be revoked on its own; its cookie stops working at once.
- Everything is behind pairing: the pages, the API and the sockets. Being on the LAN or the VPN is not enough.
- The proxy listener trusts no header the client could send through the proxy. Tailscale's login header and
  `Authorization` are dropped before anything reads them, so the local token or a forged Tailscale identity grants
  nothing there.
- As on the tailnet: only the configured name (`Host`) gets in (no DNS rebinding); writes and sockets need the page's own
  `Origin`, and writes the `x-shepherdr: 1` header no plain form or link can send; a fetch from another site is refused,
  and so is one from a sibling name on the same private domain (another `*.blackbox` page): only a link to the page opens.
- 10 wrong codes within 5 minutes void every open code (the count then starts again). Someone who can reach the proxy
  and keeps guessing can stop pairing while they do, but cannot get in; `shepherdr web pair` again once they stop.
- The cookie is `HttpOnly; Secure; SameSite=Strict; Path=/shepherdr`. Only its SHA-256 is kept, in `devices.json` in
  the service's folder (`~/.local/state/shepherdr/service/`, mode 0600). Codes and cookies are never logged.
- A link to the app from another site opens without the cookie (`SameSite=Strict`) and shows the pairing page: open it
  from the home-screen app or type the address.

## How it works

`proxy.json` in the service's folder switches it on:

```json
{ "bind": "172.30.172.1", "port": 7789, "origin": "https://shepherdr.blackbox" }
```

- `bind`: the address the service listens on for the proxy, an IP literal. `0.0.0.0` and `::` (in any spelling, `::ffff:0.0.0.0` too) are refused, so the
  service is never open on every interface. On a Docker host, the bridge gateway of the proxy's network (only
  containers on that bridge and processes on the host reach it, and none of them gets in without a device cookie).
- `port`: default 7789. The service's own listener stays on `127.0.0.1:7788`, unchanged.
- `origin`: the name the proxy serves, `https://<name>[:port]`, nothing after it.

If the address isn't there when the service starts (a Docker bridge that comes up later at boot), the service tries
again every 30 s and logs why once. Until the proxy listener is up, the web link and push alerts stay the tailnet's (or
none); the link follows within a minute of it starting.

The listener a request came in on decides how it gets in: on `127.0.0.1`, upstream's rules (tailnet owner or the local
token); on the proxy listener, only a paired device. A missing or invalid `proxy.json` leaves the mode off (the log says
why). The service reads it at start.

With proxy mode on, the machine's web link (Settings › Web, its QR code, `shepherdr web status`) is
`<origin>/shepherdr/`, also without Tailscale, and push alerts are sent with that origin as their subject.

## Commands

```sh
shepherdr web proxy setup --bind 172.30.172.1 --origin https://shepherdr.blackbox   # [--port 7789]; writes proxy.json
shepherdr web proxy status                       # what proxy.json says
shepherdr web proxy off                          # removes it
# restart the service after setup or off: systemctl --user restart shepherdr
#   (macOS: launchctl kickstart -k gui/$(id -u)/dev.shepherdr.service)
shepherdr web pair [--name Phone]                # a one-time code from the running service
shepherdr web devices                            # the paired devices and their ids
shepherdr web revoke <id>                        # that device's cookie stops working
```

`pair`, `devices` and `revoke` ask the running service on `127.0.0.1` with its token (only this machine's own user can
read it); the same routes refuse anything that came through the proxy. A paired device can also make a code for another
one, list and revoke devices on its `/shepherdr/devices` page.

Install and update need no flag: `./install.sh` (or `./install.sh --web`) installs the proxy files with the rest of
the service, and `proxy.json` lives in the service's folder, which installs and updates keep.

## The proxy

An example for Caddy with its own internal CA (not applied anywhere by this repo):

```caddy
shepherdr.blackbox {
	tls internal
	reverse_proxy 172.30.172.1:7789
}
```

Caddy passes the `Host` and `Origin` headers through as they came, which the checks above need. `/` redirects to
`/shepherdr/`. WebSockets go through `reverse_proxy` as they are.

## A phone

1. Trust the proxy's CA on the phone (for Caddy's `tls internal`: install its root certificate, then on iOS turn it on
   under Settings › General › About › Certificate Trust Settings), as for any other `*.blackbox` page.
2. Open `https://shepherdr.blackbox/` and pair: `shepherdr web pair --name Phone` on the server, type the code.
3. Add it to the home screen (Share › Add to Home Screen). Push alerts need the home-screen app on iOS: turn them on in
   the app's settings; it subscribes on that origin.
4. A lost phone: `shepherdr web devices`, then `shepherdr web revoke <id>`.

## Serve from

Serve from ([web.md](web.md)) moves which machine serves the web app. The link it shows is the serving machine's own:
its proxy link when that machine has `proxy.json`, else its tailnet link, else none. Proxy mode is not set up on the
other machine by the move: run `shepherdr web proxy setup` there yourself (and point the proxy at it).

## Not checked here

Push alerts on iOS from a home-screen app whose origin uses a private CA root are expected to work once the root is
fully trusted, but this repo cannot test that; nor the proxy reaching the bind address on a real host.
