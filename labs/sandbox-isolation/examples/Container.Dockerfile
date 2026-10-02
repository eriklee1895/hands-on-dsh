FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 -s /bin/sh -p x lab \
    && mkdir -p /run/sshd

RUN npm install --prefix /opt/dsh --omit=dev @deepseek-ai/dsh-ssh@0.1.7-rc.2 \
    && chmod -R a+rX /opt/dsh

COPY sshd_config /etc/ssh/sshd_config

USER 10001:10001
WORKDIR /work
EXPOSE 2222
