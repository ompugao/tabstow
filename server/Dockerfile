FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tabstow-server ./cmd/tabstow-server \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tabstow-server /tabstow-server
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV DB_PATH=/data/tabstow.db LISTEN_ADDR=:8080
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/tabstow-server"]
