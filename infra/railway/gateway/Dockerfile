FROM caddy:2.11-alpine
COPY Caddyfile /etc/caddy/Caddyfile
RUN AUTH_UPSTREAM=http://a:1 REST_UPSTREAM=http://r:1 STORAGE_UPSTREAM=http://s:1 REALTIME_UPSTREAM=http://rt:1 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
