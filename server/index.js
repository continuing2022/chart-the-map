const { createServer } = require('./app')

const server = createServer()
const port = server.application.config.port

server.listen(port, '0.0.0.0', () => {
  console.log(`meal-diary-api listening on ${port}`)
})
