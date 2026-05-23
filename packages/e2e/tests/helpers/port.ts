export const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;
export const CLIENT_PORT = Number(process.env.VITE_PORT) || 5173;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
export const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
