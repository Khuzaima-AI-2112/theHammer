# portal/Dockerfile
# Static single-file SPA served by nginx on port 8080 (Cloud Run requirement).
# No build step — portal/index.html is the complete artefact.
#
# Re-pin the digest periodically:
# docker pull nginx:1.27-alpine && docker inspect --format='{{index .RepoDigests 0}}' nginx:1.27-alpine
FROM nginx:1.27-alpine

# Replace default nginx config to listen on 8080
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the portal SPA
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
