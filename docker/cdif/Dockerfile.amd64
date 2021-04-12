FROM ubuntu:16.04
MAINTAINER out4b
ARG CDIF_VERSION
ARG REGISTRY
COPY './node-v12.18.2-linux-x64' '/root/node-v12.18.2-linux-x64'
COPY './jdk1.8.0_231' '/root/jdk1.8.0_231'
COPY './pylon' '/root/pylon'
ADD instantclient_19_5/* /opt/oracle/instantclient/
WORKDIR /root
ENV PATH="/root/jdk1.8.0_231/bin:/root/node-v12.18.2-linux-x64/bin:/root/pylon/bin:${PATH}"
ENV JAVA_HOME="/root/jdk1.8.0_231"
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8
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
#  echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial main restricted' > /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-updates main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial universe' >> /etc/apt/sources.list \
#  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-updates universe' >> /etc/apt/sources.list \
#  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-security main restricted' >> /etc/apt/sources.list \
#  && echo 'deb http://mirrors.aliyun.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
#  && echo 'deb-src http://mirrors.aliyun.com/ubuntu/ xenial-security universe' >> /etc/apt/sources.list \
  apt-get update \
  && chmod -x /etc/update-motd.d/* \
  && rm /etc/legal \
  && useradd -d /home/term -m -s /bin/bash term \
  && echo 'term:term' | chpasswd \
  && apt-get install -y apt-utils dialog net-tools curl build-essential python vim git tzdata libaio1 \
  && apt-get install -y libsqlite3-dev \
  && echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf \
  && ldconfig \
  && /root/node-v12.18.2-linux-x64/bin/npm config set registry ${REGISTRY} \
  && /root/node-v12.18.2-linux-x64/bin/npm config set cache /tmp/npm-cache \
  && /root/node-v12.18.2-linux-x64/bin/npm install -g bunyan --unsafe \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone \
  && echo '//public-reg.apemesh.com:8080/:_authToken=***REDACTED-REGISTRY-TOKEN***' >> /root/.npmrc \
  && /root/node-v12.18.2-linux-x64/bin/npm install -g --registry ${REGISTRY} --build-from-source --sqlite=/usr --unsafe-perm @apemesh/cdif@${CDIF_VERSION} \
  && curl -fsSL https://code-server.dev/install.sh | sh -s -- --dry-run \
  && curl -fsSL https://code-server.dev/install.sh | sh \
  && mkdir -p /root/cdif-workspace/.ExtensionData \
  && mkdir -p /root/cdif-workspace/.UserData \
  && mkdir -p /root/cdif_modules \
  && mkdir -p /root/.config/code-server \
  && printf "bind-addr: 0.0.0.0:3131\nauth: none\npassword:\ncert: false" > /root/.config/code-server/config.yaml \
#  && git clone https://github.com/mchen6/cloud9.git \
#  && cd cloud9 \
#  && /root/node-v8.12.0-linux-x64/bin/npm install \
  && rm -fr /tmp/*

#ENTRYPOINT ["/root/node-v12.18.2-linux-x64/bin/cdif"]

