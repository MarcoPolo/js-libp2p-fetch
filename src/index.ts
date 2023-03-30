/* eslint-disable max-depth */
/* eslint-disable complexity */
interface Fetch { (req: Request): Promise<Response> }

interface Duplex<TSource, TSink = TSource, RSink = Promise<void>> {
  source: AsyncIterable<TSource> | Iterable<TSource>
  sink: (source: AsyncIterable<TSink> | Iterable<TSink>) => RSink
}

const CRLF = '\r\n'
const CRLF_BYTES = (new TextEncoder()).encode(CRLF)

export function fetchViaDuplex (s: Duplex<Uint8Array>): Fetch {
  return async (request: Request): Promise<Response> => {
    const method = request.method
    const url = new URL(request.url)
    const headers = request.headers
    const path = url.pathname
    const query = url.search

    let httpRequest = `${method} ${path}${query} HTTP/1.1${CRLF}`

    headers.forEach((value, name) => {
      httpRequest += `${name}: ${value}\r\n`
    })

    // Add Host header if not present
    if (!headers.has('Host')) {
      httpRequest += `Host: ${url.host}\r\n`
    }

    let bodyBuf: ArrayBuffer | null = null
    // Figure out the content length
    if ((request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') && request.body !== null) {
      bodyBuf = await request.arrayBuffer()
      httpRequest += `Content-Length: ${bodyBuf.byteLength}\r\n`
    }

    httpRequest += '\r\n'

    void s.sink((async function * () {
      const httpRequestBuffer = new TextEncoder().encode(httpRequest)
      yield httpRequestBuffer

      if (bodyBuf != null) {
        yield new Uint8Array(bodyBuf)
      }
    })())

    const readerIt = s.source

    let statusLine = ''
    let readStatusLine = false
    let headerStrings = ''
    let readHeaderStrings = false
    const responseHeaders = new Headers()
    let chunkedEncoding = false
    let leftover = ''

    const decoder = new TextDecoder()
    const chan = syncChan()
    const chanWriter = chan.writableStream.getWriter()
    const leftoverBufAB = new ArrayBuffer(4 << 10)
    let leftoverBuf = new Uint8Array(leftoverBufAB, 0, 0)
    await new Promise<void>((resolve, reject) => {
      const consumer = (async () => {
        for await (const chunk of readerIt) {
          if (!readStatusLine || !readHeaderStrings) {
            let respString = decoder.decode(chunk)
            if (leftover !== '') {
              respString = leftover + respString
              leftover = ''
            }
            if (!readStatusLine) {
              const indexOfNewline = respString.indexOf('\r\n')
              if (indexOfNewline !== -1) {
                readStatusLine = true
                statusLine = respString.substring(0, indexOfNewline)
                respString = respString.substring(indexOfNewline + 2)
              } else {
                // Didn't find the newline marker, keep this as leftover
                leftover = respString
              }
            }
            if (readStatusLine && !readHeaderStrings) {
              const indexOfNewline = respString.indexOf('\r\n')
              if (indexOfNewline === 0) {
                // No headers
                readHeaderStrings = true
                resolve()
                respString = respString.substring(indexOfNewline + 2)
                // eslint-disable-next-line max-depth
                if (respString !== '') {
                  const respStringBuf = new TextEncoder().encode(respString)
                  await chanWriter.write(respStringBuf)
                }
                continue
              }
              const indexOfNewlines = respString.indexOf('\r\n\r\n')
              if (indexOfNewlines !== -1) {
                headerStrings = respString.substring(0, indexOfNewlines)
                readHeaderStrings = true
                // eslint-disable-next-line max-depth
                if (headerStrings !== '') {
                  headerStrings.split('\r\n').forEach((header) => {
                    const [k, v] = header.split(': ')
                    try {
                      responseHeaders.set(k, v)
                    } catch (e) {
                      // eslint-disable-next-line no-console
                      console.warn("Couldn't set header", k, v, e)
                    }
                  })
                }
                // eslint-disable-next-line max-depth
                if (responseHeaders.get('Transfer-Encoding') === 'chunked') {
                  chunkedEncoding = true
                }
                resolve()
                respString = respString.substring(indexOfNewlines + 4)
                // Send the leftover to the body reader
                if (respString !== '') {
                  const respStringBuf = new TextEncoder().encode(respString)
                  if (chunkedEncoding) {
                    const restBuf = await parseChunkedEncodedBody(respStringBuf, chanWriter)
                    if (restBuf.byteLength > 0) {
                      leftoverBuf = new Uint8Array(leftoverBufAB, 0, restBuf.byteLength)
                      for (let i = 0; i < restBuf.byteLength; i++) {
                        leftoverBuf[i] = restBuf[i]
                      }
                    }
                  } else {
                    await chanWriter.write(respStringBuf)
                  }
                }
              } else {
                // Didn't find the newline marker, keep this as leftover
                leftover = respString
              }
            }
          } else {
          // We just need to read the body now
            if (chunkedEncoding) {
              if (leftoverBuf.length > 0) {
                const leftoverBytes = leftoverBuf.length
                // Some leftover bytes, use them
                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                leftoverBuf = new Uint8Array(leftoverBufAB, 0, leftoverBuf.length + chunk.length)
                for (let i = 0; i < chunk.length; i++) {
                  leftoverBuf[leftoverBytes + i] = chunk[i]
                }
              } else {
                leftoverBuf = chunk
              }
              const restBuf = await parseChunkedEncodedBody(leftoverBuf, chanWriter)
              if (restBuf.byteLength > 0) {
                leftoverBuf = new Uint8Array(leftoverBufAB, 0, restBuf.byteLength)
                for (let i = 0; i < restBuf.byteLength; i++) {
                  leftoverBuf[i] = restBuf[i]
                }
              } else {
                leftoverBuf = new Uint8Array(leftoverBufAB, 0, 0)
              }
            } else {
              await chanWriter.write(chunk)
            }
          }
        }

        if (!readHeaderStrings) {
          readHeaderStrings = true
          resolve()
        }

        await chanWriter.close()
      })()
      consumer.catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error('Consumer errored:', err)
        await chanWriter.abort(err)
      })
    })

    const statusParts = statusLine.split(' ')
    if (statusParts.length < 2) {
      throw new Error('Invalid status line')
    }
    if (statusParts.shift() !== 'HTTP/1.1') {
      throw new Error('Invalid HTTP version')
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const status = parseInt(statusParts.shift()!, 10)
    const statusText = statusParts.join(' ')

    let bodyReader: ReadableStream | null = chan.readableStream
    if (status === 204 || status === 205 || status === 304) {
      bodyReader = null
    }

    return new Response(bodyReader, {
      status,
      statusText,
      headers: responseHeaders
    })
  }
}

// A channel with backpressure and no buffer. Reads need an accompanying write.
function syncChan (): { readableStream: ReadableStream<Uint8Array>, writableStream: WritableStream<Uint8Array> } {
  const queueingStrategy = new ByteLengthQueuingStrategy({ highWaterMark: 1 })
  const chunkSize = 16 << 10

  interface QNode {
    buf: ArrayBufferView
    resolve: (size: number) => void
    reject: (err: Error) => void
  }
  interface WriterBlocked {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
  }
  const pendingReads: QNode[] = []
  const pendingWrites: WriterBlocked[] = []
  let writerClosed = false

  const writableStream = new WritableStream({
    // Implement the sink
    async write (chunk: ArrayBufferView) {
      let limit = 0
      let chunkBuf
      if (chunk instanceof Uint8Array) {
        chunkBuf = chunk
      } else {
        chunkBuf = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      }

      // Any pending readers?
      while (chunkBuf.length > 0) {
        while (pendingReads.length === 0) {
          await (new Promise((resolve, reject) => {
            pendingWrites.push({ resolve, reject })
          }))
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const readNode = (pendingReads.pop())!
        if (writerClosed) {
          readNode.reject(new Error('Writer closed'))
          return
        }

        let readBuf
        if (readNode.buf instanceof Uint8Array) {
          readBuf = readNode.buf
        } else {
          readBuf = new Uint8Array(readNode.buf.buffer, readNode.buf.byteOffset, readNode.buf.byteLength)
        }

        limit = Math.min(readBuf.length, chunkBuf.length)
        for (let index = 0; index < limit; index++) {
          readBuf[index] = chunkBuf[index]
        }

        chunkBuf = chunkBuf.slice(limit)

        readNode.resolve(limit)
      }
    },
    close () {
      writerClosed = true
      if (pendingReads.length > 0) {
        pendingReads.forEach((node) => {
          node.reject(new Error('Writer closed'))
        })
      }
    },
    abort (err) {
      writerClosed = true
      if (pendingReads.length > 0) {
        pendingReads.forEach((node) => {
          node.reject(new Error('Writer closed'))
        })
      }

      // eslint-disable-next-line no-console
      console.error('Writer aborted', err)
    }
  }, queueingStrategy)

  const supportsByobReader = (typeof ReadableByteStreamController !== 'undefined')

  const readableStream = new ReadableStream({
    type: supportsByobReader ? 'bytes' : undefined,
    autoAllocateChunkSize: supportsByobReader ? chunkSize : undefined,
    start (controller) { },
    async pull (controller) {
      if (writerClosed) {
        controller.close()
        return
      }
      // @ts-expect-error
      if (controller.byobRequest?.view != null) {
        // @ts-expect-error
        const r: ReadableStreamBYOBRequest = controller.byobRequest
        const nPromise: Promise<number> = new Promise((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          pendingReads.push({ buf: r.view!, resolve, reject })
        })
        if (pendingWrites.length > 0) {
          // Unblock writer
          pendingWrites.pop()?.resolve(undefined)
        }

        try {
          const val = await nPromise
          r.respond(val)
        } catch (err) {
          if (writerClosed) {
            controller.close()
            return
          }
          controller.error(err)
        }
      } else {
        const buffer = new ArrayBuffer(chunkSize)
        const view = new Uint8Array(buffer)
        const nPromise: Promise<number> = new Promise((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          pendingReads.push({ buf: view, resolve, reject })
        })
        if (pendingWrites.length > 0) {
          // Unblock writer
          pendingWrites.pop()?.resolve(undefined)
        }

        try {
          const n = await nPromise
          controller.enqueue(new Uint8Array(buffer, 0, n))
        } catch (err) {
          if (writerClosed) {
            controller.close()
            return
          }
          controller.error(err)
        }
      }
    }
  })

  return { readableStream, writableStream }
}

// Parse a chunked encoded body. Returns the remaining body.
async function parseChunkedEncodedBody (body: Uint8Array, writer: WritableStreamDefaultWriter): Promise<Uint8Array> {
  enum State {
    ReadingChunkSize = 1,
    ReadingContent = 2,
  }
  let state: State = State.ReadingChunkSize
  let chunkSize = 0
  let chunkSizeIdx = 0
  while (body.length > 0) {
    if (state === State.ReadingChunkSize) {
      // Read the chunk size
      const idx = body.indexOf(CRLF_BYTES[0])
      if (idx === -1) {
        // Not enough body
        return body
      }
      if (body[idx + 1] !== CRLF_BYTES[1]) {
        // Not enough body
        return body
      }
      state = State.ReadingContent
      chunkSize = parseInt(new TextDecoder().decode(body.slice(0, idx)), 16)
      chunkSizeIdx = idx
    } else {
      const bodyAfterChunk = body.subarray(chunkSizeIdx + 2)
      if (bodyAfterChunk.length < chunkSize + 2) {
        // Not enough body
        return body
      }
      await writer.write(bodyAfterChunk.subarray(0, chunkSize))
      // Only advance the body after we've wrtting the chunk
      body = bodyAfterChunk.subarray(chunkSize + 2)
      state = State.ReadingChunkSize
    }
  }
  return body
}
