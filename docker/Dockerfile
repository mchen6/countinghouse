FROM ubuntu:16.04
MAINTAINER out4b
COPY './node-v4.5.0-linux-x64' '/root/node-v4.5.0-linux-x64'
WORKDIR /root
ENV PATH="/root/node-v4.5.0-linux-x64/bin:${PATH}"
EXPOSE 3049
RUN \
  echo 'deb http://cn.archive.ubuntu.com/ubuntu/ xenial main restricted' > /etc/apt/sources.list \
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
  && apt-get install -y apt-utils dialog net-tools curl build-essential python \
  && /root/node-v4.5.0-linux-x64/bin/npm config set registry http://172.17.0.1:8000/ \
  && /root/node-v4.5.0-linux-x64/bin/npm install -g bunyan \
  && /root/node-v4.5.0-linux-x64/bin/npm install -g --registry http://172.17.0.1:8000/ --unsafe-perm cdif@latest

ENTRYPOINT ["/root/node-v4.5.0-linux-x64/bin/cdif"]
