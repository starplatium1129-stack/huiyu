'use strict'

class CardError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

module.exports = { CardError }
