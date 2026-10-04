/**
 * Browser API authorization.
 *
 * `authorize` is exported by the host half precisely so these fences can be
 * tested without a live server: the loopback `Host` check and the per-boot
 * token requirement are the only things standing between a page (or a local
 * process) and the annotation store.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { authorize } from '../index.js'

const TOKEN = 'a-per-boot-token'

function request(headers, url) {
  return { headers, url }
}

test('before a page is served, the static marker header is enough', () => {
  assert.equal(authorize(request({ host: '127.0.0.1:3080', 'x-dsh-annotation': '1' }), TOKEN, false), true)
  assert.equal(authorize(request({ host: '127.0.0.1:3080' }), TOKEN, false), false)
  assert.equal(authorize(request({ host: '127.0.0.1:3080', 'x-dsh-annotation': 'yes' }), TOKEN, false), false)
})

test('once the token is published, only the token is accepted', () => {
  const good = request({ host: '127.0.0.1:3080', 'x-dsh-annotate-token': TOKEN })
  assert.equal(authorize(good, TOKEN, true), true)

  const markerOnly = request({ host: '127.0.0.1:3080', 'x-dsh-annotation': '1' })
  assert.equal(authorize(markerOnly, TOKEN, true), false)

  const wrong = request({ host: '127.0.0.1:3080', 'x-dsh-annotate-token': 'guessed' })
  assert.equal(authorize(wrong, TOKEN, true), false)

  const missing = request({ host: '127.0.0.1:3080' })
  assert.equal(authorize(missing, TOKEN, true), false)
})

test('a non-loopback Host is refused even with the correct token', () => {
  // This is the DNS-rebinding fence: the browser can be pointed at 127.0.0.1
  // while still sending the attacker's own Host.
  for (const host of ['evil.example', '10.0.0.5:3080', '127.0.0.1.evil.example', 'notlocalhost']) {
    assert.equal(
      authorize(request({ host, 'x-dsh-annotate-token': TOKEN }), TOKEN, true),
      false,
      `${host} must be refused`,
    )
  }
})

test('loopback spellings are accepted', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:3080', 'localhost', 'LOCALHOST:80', '[::1]', '[::1]:3080']) {
    assert.equal(
      authorize(request({ host, 'x-dsh-annotate-token': TOKEN }), TOKEN, true),
      true,
      `${host} must be accepted`,
    )
  }
})

test('an empty token never weakens the fence into token-less access', () => {
  // A host that could not mint or publish a token must fall back to the marker
  // header, not accept everyone.
  const markerOnly = request({ host: '127.0.0.1:3080', 'x-dsh-annotation': '1' })
  assert.equal(authorize(markerOnly, '', true), true)
  assert.equal(authorize(request({ host: '127.0.0.1:3080' }), '', true), false)
})

test('a request without headers or with a missing host is refused', () => {
  assert.equal(authorize(request({}, TOKEN, false), TOKEN, false), false)
  assert.equal(authorize(undefined, TOKEN, false), false)
  assert.equal(authorize(undefined, TOKEN, true), false)
})
