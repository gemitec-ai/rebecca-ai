module.exports = {
  '/api/v1/lounge': {
    target: 'http://localhost:8083',
    secure: false,
    changeOrigin: true,
    logLevel: 'debug',
  },
};
