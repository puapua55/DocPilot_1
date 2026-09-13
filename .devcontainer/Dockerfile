FROM mcr.microsoft.com/devcontainers/java:1-21-bullseye

ARG MAVEN_VERSION=3.9.16

USER root

# Install Maven from the official Apache binary distribution. This avoids
# relying on the EOL Debian Bullseye Maven package metadata during rebuilds.
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
