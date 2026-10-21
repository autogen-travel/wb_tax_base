# Browser version

The web version serves the existing UI and proxies report requests to the WB Finance API. It can run on a VPS with Docker Compose and a domain name.

## Deploy

1. Point the domain's DNS A record (and AAAA record, if used) to the VPS. Allow inbound ports 80 and 443 in the firewall.
2. Install Docker Engine and the Docker Compose plugin on the VPS.
3. Copy this directory to the VPS, then create its private `.env` file:

   ```sh
   cp .env.example .env
   ```

4. Set `DOMAIN` to the domain name and `APP_PASSWORD` to a private password. Generate one with `openssl rand -base64 32`.
5. Start the app:

   ```sh
   docker compose up -d --build
   ```

Caddy requests and renews the HTTPS certificate automatically. Open `https://DOMAIN` and sign in with `APP_PASSWORD`.

## Cabinet tokens

Cabinet names and WB Finance tokens are saved in that browser's local storage. They are not written to the server's filesystem or database; the browser sends the selected token to the server only when it requests a report, over HTTPS. Use a personal or service token for the Finance category. Each browser/device has its own cabinet list.

## Update

Copy the updated project files to the VPS and run:

```sh
docker compose up -d --build
```

Session cookies are HTTP-only, same-site, and secure. The server keeps active sessions and per-token WB request limits in memory; restarting the container clears sessions and limits. The app requires Node.js 22 or later when run outside Docker.
