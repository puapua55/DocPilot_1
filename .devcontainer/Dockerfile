FROM mcr.microsoft.com/devcontainers/java:1-21-bookworm

ARG MAVEN_VERSION=3.9.16

USER root

# Pull the current Bookworm security updates whenever the development image is
# rebuilt. The JDK assertion prevents a cached pre-eMudhra image from being
# accepted silently; Microsoft OpenJDK 21.0.12.1 is the first patched build on
# this release line.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends git-lfs \
    && java -version 2>&1 | grep -Eq 'version "21\.0\.(12\.[1-9]|1[3-9]|[2-9][0-9])' \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# Install Maven from the official Apache binary distribution so its version is
# explicit and independent of the Debian package metadata.
RUN curl -fsSL "https://dlcdn.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
       -o /tmp/apache-maven.tar.gz \
    && curl -fsSL "https://downloads.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz.sha512" \
       -o /tmp/apache-maven.tar.gz.sha512 \
    && echo "$(awk '{print $1}' /tmp/apache-maven.tar.gz.sha512)  /tmp/apache-maven.tar.gz" | sha512sum --check \
    && tar -xzf /tmp/apache-maven.tar.gz -C /opt \
    && ln -s "/opt/apache-maven-${MAVEN_VERSION}" /opt/maven \
    && ln -s /opt/maven/bin/mvn /usr/local/bin/mvn \
    && rm -f /tmp/apache-maven.tar.gz /tmp/apache-maven.tar.gz.sha512

ENV MAVEN_HOME=/opt/maven
ENV PATH="${MAVEN_HOME}/bin:${PATH}"

USER vscode
