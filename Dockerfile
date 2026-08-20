FROM nginx:alpine

# nginx:alpine's entrypoint runs envsubst over /etc/nginx/templates/*.template
# and writes the result to /etc/nginx/conf.d/. NGINX_ENVSUBST_FILTER limits
# substitution to YUME_* names, so nginx's own runtime variables ($host,
# $remote_addr, $connection_upgrade, ...) are left untouched.
ENV NGINX_ENVSUBST_FILTER="YUME_"
ENV YUME_UPSTREAM="suwayomi:4567"

COPY nginx.conf /etc/nginx/templates/default.conf.template

COPY index.html manifest.json /usr/share/nginx/html/
COPY css/   /usr/share/nginx/html/css/
COPY js/    /usr/share/nginx/html/js/
COPY icons/ /usr/share/nginx/html/icons/

EXPOSE 80

# 127.0.0.1, not localhost: localhost resolves to ::1 in this image and nginx
# listens on IPv4 only, so wget would connect to [::1]:80 and always fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/manifest.json >/dev/null 2>&1 || exit 1
