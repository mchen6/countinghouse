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
#  echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial main restricted' > /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
#  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
#  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://cn.archive.ubuntu.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \

  echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial main restricted' > /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
  && apt-get update \
  && chmod -x /etc/update-motd.d/* \
  && rm /etc/legal \
  && useradd -d /home/term -m -s /bin/bash term \
  && echo 'term:term' | chpasswd \
  && apt-get install -y apt-utils dialog net-tools curl build-essential python vim nano \
  && apt-get install -y libsqlite3-dev \
  && /root/node-v6.5.0-linux-x64/bin/npm config set registry http://public-reg.apemesh.com:8080/ \
  && /root/node-v6.5.0-linux-x64/bin/npm install -g bunyan \
#  && /root/node-v6.5.0-linux-x64/bin/npm install -g --unsafe-perm wetty \
  && /root/node-v6.5.0-linux-x64/bin/npm install -g --registry http://public-reg.apemesh.com:8080/ --build-from-source --sqlite=/usr/local --unsafe-perm cdif@${CDIF_VERSION} \
  && rm -fr /tmp/*

#ENTRYPOINT ["/root/node-v6.5.0-linux-x64/bin/cdif"]


