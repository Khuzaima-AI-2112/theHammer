# portal/Dockerfile
# Static SPA served by nginx on port 8080 (Cloud Run requirement).
#
# No build step: the portal is plain HTML/CSS/JS (AGENTS.md rule 3) and is
# served exactly as it sits in the repository.
#
# The whole directory is copied rather than a list of named files. Until #31
# this copied only nginx.conf and index.html, which was true of the June 24
# build — a single 2557-line file with the CSS and JS inlined. index.html has
# since been split into app.js, styles.css and logo.png, and auth-ext.html was
# added, and none of them reached the image. Copying `.` means the next asset
# someone adds is deployed instead of silently going missing.
#
# Re-pin the digest periodically:
# docker pull nginx:1.27-alpine && docker inspect --format='{{index .RepoDigests 0}}' nginx:1.27-alpine
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

# Replace default nginx config to listen on 8080
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the portal. .dockerignore keeps build inputs out of the context; nginx.conf
# cannot be ignored there because the COPY above needs it, so it is removed from
# the web root here instead of being served.
COPY . /usr/share/nginx/html/
RUN rm -f /usr/share/nginx/html/nginx.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
