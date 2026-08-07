FROM ubuntu:16.04
MAINTAINER mchen6
ARG COUNTINGHOUSE_VERSION
ARG CODESERVER_VERSION
# ADD instantclient_19_5/* /opt/oracle/instantclient/
WORKDIR /root
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8
#VOLUME ["/root/node_modules"]
EXPOSE 9527 3000

# Setup base installation packages
RUN set -ex; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        apt-utils \
        dialog \
        net-tools \
        wget \
        build-essential \
        python \
        vim \
        git \
        coreutils \
        tzdata \
        libaio1 \
        apt-transport-https \
        ca-certificates \
        dirmngr \
        gnupg \
        git \
        dnsutils \
        curl \
        libsqlite3-dev \
     ; \
    curl -sSL "https://deb.nodesource.com/setup_12.x" | bash - ; \
    apt-get install -y nodejs; \
    rm -rf /var/lib/apt/lists/* ; \
    chmod -x /etc/update-motd.d/* ; \
    rm /etc/legal ; \
    useradd -d /home/term -m -s /bin/bash term ; \
    echo 'term:term' | chpasswd


# Setup Java
ENV JAVA_PKG=https://download.oracle.com/java/19/latest/jdk-19_linux-x64_bin.tar.gz \
      JAVA_HOME=/usr/java/jdk-19
RUN set -eux; \
      JAVA_SHA256=$(curl "$JAVA_PKG".sha256) ; \
      curl --output /tmp/jdk.tgz "$JAVA_PKG" && \
      echo "$JAVA_SHA256 */tmp/jdk.tgz" | sha256sum -c; \
      mkdir -p "$JAVA_HOME"; \
      tar --extract --file /tmp/jdk.tgz --directory "$JAVA_HOME" --strip-components 1
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Setup npm packages
RUN set -ex; \
    npm config set cache /tmp/npm-cache ; \
    npm install -g bunyan --unsafe

# Install countinghouse
RUN set -ex; \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime ; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime ; \
    echo $TZ > /etc/timezone ; \
    npm install -g --build-from-source --sqlite=/usr --unsafe-perm countinghouse@${COUNTINGHOUSE_VERSION}

# Install and setup Code server
RUN set -ex; \
    curl -fsSL https://code-server.dev/install.sh | sh -s -- --dry-run ; \
    curl -fsSL https://code-server.dev/install.sh | sh -s -- --version=${CODESERVER_VERSION} ; \
    mkdir -p /root/countinghouse-workspace/.ExtensionData ; \
    mkdir -p /root/countinghouse-workspace/.UserData ; \
    mkdir -p /root/countinghouse_modules ; \
    mkdir -p /root/.config/code-server ; \
    printf "bind-addr: 0.0.0.0:3131\nauth: none\npassword:\ncert: false" > /root/.config/code-server/config.yaml ; \
    rm -fr /tmp/*



# Setup Oracle Instant Client
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient_21_4

RUN set -ex; \
    apt-get update ; \
    apt-get install -y libpq-dev zlib1g-dev shared-mime-info libaio1 libaio-dev unzip --no-install-recommends ; \
    wget https://download.oracle.com/otn_software/linux/instantclient/214000/instantclient-sdk-linux.x64-21.4.0.0.0dbru.zip ; \
    wget https://download.oracle.com/otn_software/linux/instantclient/214000/instantclient-sqlplus-linux.x64-21.4.0.0.0dbru.zip ; \
    wget https://download.oracle.com/otn_software/linux/instantclient/214000/instantclient-basic-linux.x64-21.4.0.0.0dbru.zip ; \
    mkdir -p /opt/oracle ; \
    cp instantclient-* /opt/oracle/ ; \
    cd /opt/oracle/ ; \
    unzip instantclient-basic-linux.x64-21.4.0.0.0dbru.zip ; \
    unzip instantclient-sdk-linux.x64-21.4.0.0.0dbru.zip ; \
    unzip instantclient-sqlplus-linux.x64-21.4.0.0.0dbru.zip ; \
    echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf ; \
    ldconfig ; \
    rm -rf /var/lib/apt/lists/* ; \
    rm -fr /root/instantclient-*.zip ; \
    apt -y clean ; \
    apt -y autoremove ; \
    rm -rf /var/cache/apt


#ENTRYPOINT ["/root/node-v12.18.2-linux-x64/bin/countinghouse"]

