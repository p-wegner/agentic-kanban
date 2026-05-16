export const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;
export const CLIENT_PORT = Number(process.env.VITE_PORT) || 5173;
export const SERVER_URL = `http://localhost:${SERVER_PORT}`;
export const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
