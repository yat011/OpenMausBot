# Headed desktop sidecar for the omb bot: Xvfb + xfwm4 + Google Chrome with
# a CDP port the omb container attaches to, plus a noVNC web viewer on 6901.
# Mirrors the old box's headed setup (DISPLAY :7, CDP 9229).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:7 \
    CHROME_PROFILE=/profile

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/google.pub https://dl.google.com/linux/linux_signing_key.pub \
  && test -s /tmp/google.pub \
  && gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /tmp/google.pub \
  && rm /tmp/google.pub \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xfwm4 x11vnc novnc websockify dbus-x11 \
    google-chrome-stable fonts-noto-cjk fonts-liberation procps \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/desktop-entrypoint.sh
RUN chmod +x /usr/local/bin/desktop-entrypoint.sh

VOLUME ["/profile"]
EXPOSE 6901 9229

ENTRYPOINT ["/usr/local/bin/desktop-entrypoint.sh"]
