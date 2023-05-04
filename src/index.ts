/* eslint-disable max-depth */
/* eslint-disable complexity */

import { type Uint8ArrayList, isUint8ArrayList } from 'uint8arraylist'
interface Fetch { (req: Request): Promise<Response> }

interface Duplex<TSource, TSink = TSource, RSink = Promise<void>> {
  source: AsyncIterable<TSource> | Iterable<TSource>
  sink: (source: AsyncIterable<TSink> | Iterable<TSink>) => RSink
}

export function fetchViaDuplex (s: Duplex<Uint8Array | Uint8ArrayList>): Fetch {
  return async (req) => {
    await writeRequestToDuplex(s, req)
    const stream = new ReadableStream<Uint8Array>({
      async start (controller) {
        try {
          for await (const chunk of s.source) {
            if (isUint8ArrayList(chunk)) {
              for (const c of chunk) {
                controller.enqueue(c)
              }
            } else {
              controller.enqueue(chunk)
            }
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      }
    })

    const h = new HttpParser()
    const r = await h.parse(stream)
    return new Response((h.status === 204 || h.status === 205 || h.status === 304) ? null : r, {
      status: h.status,
      statusText: h.statusText,
      headers: h.headers
    })
  }
}

const CRLF = '\r\n'
async function writeRequestToDuplex (s: Duplex<unknown, Uint8Array>, request: Request): Promise<void> {
  const method = request.method
  const url = new URL(request.url)
  const headers = request.headers
  const path = url.pathname
  const query = url.search

  let httpRequest = `${method} ${path}${query} HTTP/1.1${CRLF}`

  headers.forEach((value, name) => {
    httpRequest += `${name}: ${value}${CRLF}`
  })

  // Add Host header if not present
  if (!headers.has('Host')) {
    httpRequest += `Host: ${url.host}${CRLF}`
  }

  // Do we need this?
  // const bodyBuf: ArrayBuffer | null = null
  // Figure out the content length
  // if ((request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') && request.body !== null) {
  //   bodyBuf = await request.arrayBuffer()
  //   httpRequest += `Content-Length: ${bodyBuf.byteLength}\r\n`
  // }

  httpRequest += CRLF

  void s.sink((async function * () {
    const httpRequestBuffer = new TextEncoder().encode(httpRequest)
    yield httpRequestBuffer

    if (request.body == null) {
      return
    }
    const reader = request.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        // If the stream is done, break the loop
        if (done) {
          break
        }
        yield value
      }
    } finally {
      reader.releaseLock()
    }

    // if (bodyBuf != null) {
    //   yield new Uint8Array(bodyBuf)
    // }
  })())
}

enum DecodingState {
  readingSize,
  readingBody,
  readingCRLF,
}

class MaybeChunkedDecoder extends TransformStream<Uint8Array, Uint8Array> {
  private isChunked = false
  private remaining = 0
  private state: DecodingState = DecodingState.readingSize
  private chunkSizeBuffer = ''
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()

  setIsChunked (): void {
    this.isChunked = true
  }

  constructor () {
    super({
      transform: (inputChunk, controller) => {
        if (!this.isChunked) {
          controller.enqueue(inputChunk)
          return
        }

        let inputOffset = 0

        while (inputOffset < inputChunk.length) {
          if (this.state === DecodingState.readingSize) {
            const lineEnd = inputChunk.indexOf(0x0a, inputOffset) // Find LF

            if (lineEnd === -1) {
              this.chunkSizeBuffer += this.decoder.decode(inputChunk.subarray(inputOffset), {
                stream: true
              })
              break
            }

            this.chunkSizeBuffer += this.decoder.decode(inputChunk.subarray(inputOffset, lineEnd), {
              stream: true
            })
            this.remaining = parseInt(this.chunkSizeBuffer.trim(), 16)
            this.chunkSizeBuffer = ''
            inputOffset = lineEnd + 1

            if (this.remaining === 0) {
              break
            }

            this.state = DecodingState.readingBody
          } else if (this.state === DecodingState.readingBody) {
            const bytesToRead = Math.min(this.remaining, inputChunk.length - inputOffset)
            const bytesRead = inputChunk.subarray(inputOffset, inputOffset + bytesToRead)
            controller.enqueue(bytesRead)
            inputOffset += bytesToRead
            this.remaining -= bytesToRead

            if (this.remaining === 0) {
              this.state = DecodingState.readingCRLF
            }
          } else if (this.state === DecodingState.readingCRLF) {
            const lineEnd = inputChunk.indexOf(0x0a, inputOffset) // Find LF
            if (lineEnd === -1) {
              this.chunkSizeBuffer += this.decoder.decode(inputChunk.subarray(inputOffset), {
                stream: true
              })
              break
            }

            this.chunkSizeBuffer += this.decoder.decode(inputChunk.subarray(inputOffset, lineEnd), {
              stream: true
            })
            inputOffset = lineEnd + 1
            this.state = DecodingState.readingSize
          }
        }
      },

      flush: (controller) => {
        if (this.remaining > 0) {
          controller.enqueue(this.encoder.encode(this.chunkSizeBuffer))
        }
      }
    })
  }
}

class HttpParser {
  headers: Headers = new Headers()
  status: number = 0
  statusText: string = ''

  private static parseHeaders (lines: string[]): Headers {
    const headers = new Headers()
    for (const line of lines) {
      const [name, value] = line.split(': ', 2)
      headers.set(name.toLowerCase(), value)
    }
    return headers
  }

  public async parse (stream: ReadableStream): Promise<ReadableStream<Uint8Array>> {
    const t = this
    const maybeChunkedDecoder = new MaybeChunkedDecoder()
    let headersParsed = false
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

    let headerText = ''

    return await new Promise((resolve, reject) => {
      stream
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            async transform (chunk, controller) {
              if (!headersParsed) {
                try {
                  headerText += new TextDecoder().decode(chunk, { stream: true })
                  const headerEndIndex = headerText.indexOf('\r\n\r\n')

                  if (headerEndIndex >= 0) {
                    const headerLines = headerText.slice(0, headerEndIndex).split('\r\n')
                    const [version, statusCode] = headerLines[0].split(' ')
                    t.status = parseInt(statusCode, 10)
                    t.headers = HttpParser.parseHeaders(headerLines.slice(1))
                    t.statusText = headerLines[0].substring(version.length + statusCode.length + 2)

                    if (t.headers.get('transfer-encoding') === 'chunked') {
                      maybeChunkedDecoder.setIsChunked()
                    }

                    headersParsed = true
                    resolve(readable)

                    const bodyStartIndex = headerEndIndex + 4
                    const bodyChunk = chunk.subarray(bodyStartIndex)

                    if (bodyChunk.byteLength > 0) {
                      controller.enqueue(bodyChunk)
                    }
                  } else {
                    // Do nothing, we need more data
                  }
                } catch (err) {
                  reject(err)
                }
              } else {
                controller.enqueue(chunk)
              }
            }
          })
        )
        .pipeThrough(maybeChunkedDecoder)
        .pipeTo(writable)
        .then(() => {
          if (!headersParsed) {
            reject(new Error('No headers parsed'))
          }
        })
        .catch((err) => {
          if (!headersParsed) {
            reject(err)
          }
          // eslint-disable-next-line no-console
          console.warn('Error parsing HTTP response:', err)
        })
    })
  }
}
