FROM ubuntu:16.04
MAINTAINER out4b
ARG CDIF_VERSION
ARG REGISTRY
COPY './node-v6.5.0-linux-x64' '/root/node-v6.5.0-linux-x64'
WORKDIR /root
ENV PATH="/root/node-v6.5.0-linux-x64/bin:${PATH}"
VOLUME ["/root/node_modules"]
EXPOSE 9527 3000
RUN \
  echo '10.0.0.132      registry.apemesh.com' >> /etc/hosts \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial main restricted' > /etc/apt/sources.list \
  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
  &&echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
  && apt-get update \
  && chmod -x /etc/update-motd.d/* \
  && rm /etc/legal \
  && useradd -d /home/term -m -s /bin/bash term \
  && echo 'term:term' | chpasswd \
  && apt-get install -y apt-utils dialog net-tools curl build-essential python vim nano \
  && /root/node-v6.5.0-linux-x64/bin/npm config set registry ${REGISTRY} \
  && /root/node-v6.5.0-linux-x64/bin/npm install -g bunyan \
  && /root/node-v6.5.0-linux-x64/bin/npm install -g --unsafe-perm wetty \
  && /root/node-v6.5.0-linux-x64/bin/npm install -g --registry ${REGISTRY} --unsafe-perm cdif@${CDIF_VERSION} \
  && rm -fr /tmp/*

#ENTRYPOINT ["/root/node-v6.5.0-linux-x64/bin/cdif"]


