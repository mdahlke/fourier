# nginx running as a non-root user (uid 101)
FROM nginxinc/nginx-unprivileged:1.28-alpine

# Analytics settings (empty = off). Set these in Coolify's environment variables.
ENV UMAMI_HOST="" \
    UMAMI_WEBSITE_ID="" \
    UMAMI_SCRIPT_NAME="script.js" \
    UMAMI_DOMAINS="" \
    NGINX_ENVSUBST_FILTER="^UMAMI_"

COPY --chown=root:root nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=root:root public/ /usr/share/nginx/html/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO /dev/null http://127.0.0.1/healthz || exit 1
