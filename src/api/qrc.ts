/**
 * QQ 音乐 QRC 解密入口。
 * Triple DES 实现沿用 SPlayer-Next/LDDC 的兼容算法。
 */
import { inflateRawSync, inflateSync, unzipSync } from 'node:zlib'
import { qrcDecrypt } from './tripledes.js'

const QRC_KEY = new Uint8Array(Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8'))

export const decryptQrc = (encryptedQrc?: string) => {
  if (!encryptedQrc?.trim()) return undefined
  const decrypted = Buffer.from(
    qrcDecrypt(new Uint8Array(Buffer.from(encryptedQrc, 'hex')), QRC_KEY),
  )
  for (const inflate of [inflateSync, inflateRawSync, unzipSync]) {
    try {
      return inflate(decrypted).toString('utf8')
    } catch {
      // 依次尝试 zlib、raw deflate、gzip。
    }
  }
  const text = decrypted.toString('utf8')
  return text.includes('[') || text.includes('<') ? text : undefined
}
