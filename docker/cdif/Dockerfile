FROM ubuntu:16.04
MAINTAINER out4b
ARG CDIF_VERSION
ARG REGISTRY
COPY './node-v10.15.3-linux-x64' '/root/node-v10.15.3-linux-x64'
COPY './pylon' '/root/pylon'
WORKDIR /root
ENV PATH="/root/node-v10.15.3-linux-x64/bin:/root/pylon/bin:${PATH}"
#VOLUME ["/root/node_modules"]
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
  && apt-get install -y apt-utils dialog net-tools curl build-essential python vim git tzdata \
  && apt-get install -y libsqlite3-dev \
  && /root/node-v10.15.3-linux-x64/bin/npm config set registry ${REGISTRY} \
  && /root/node-v10.15.3-linux-x64/bin/npm config set cache /tmp/npm-cache \
  && /root/node-v10.15.3-linux-x64/bin/npm install -g bunyan \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo '//public-reg.apemesh.com:8080/:_authToken=***REDACTED-REGISTRY-TOKEN***' >> /root/.npmrc \
  && /root/node-v10.15.3-linux-x64/bin/npm install -g --registry ${REGISTRY} --build-from-source --sqlite=/usr/local --unsafe-perm @apemesh/cdif@${CDIF_VERSION} \
#  && git clone https://github.com/mchen6/cloud9.git \
#  && cd cloud9 \
#  && /root/node-v8.12.0-linux-x64/bin/npm install \
  && rm -fr /tmp/*

#ENTRYPOINT ["/root/node-v10.15.3-linux-x64/bin/cdif"]

