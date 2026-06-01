const LOOPBACK_HOST = "127.0.0.1";

export function getServerPort() {
  return Number(process.env.SERVER_PORT) || 3001;
}

export function boardApiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${LOOPBACK_HOST}:${getServerPort()}${normalizedPath}`;
}
