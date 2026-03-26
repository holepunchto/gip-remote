const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const GitPearLink = require('../lib/link')

test('link - parse', async (t) => {
  const key = b4a.alloc(32, 'test')
  const res = GitPearLink.parse(`git+pear://${z32.encode(key)}/my-repo`)

  t.is(res.drive.key.toString('hex'), key.toString('hex'))
  t.is(res.drive.length, -1)
  t.is(res.drive.fork, null)
  t.is(res.pathname, '/my-repo')
})

test('link - parse w/length', async (t) => {
  const key = b4a.alloc(32, 'test')
  const res = GitPearLink.parse(`git+pear://0.1.${z32.encode(key)}/my-repo`)

  t.is(res.drive.key.toString('hex'), key.toString('hex'))
  t.is(res.drive.length, 1)
  t.is(res.drive.fork, 0)
  t.is(res.pathname, '/my-repo')
})

test('link - serialize', async (t) => {
  const key = b4a.alloc(32, 'test')
  const url = GitPearLink.serialize({
    protocol: 'git+pear:',
    pathname: '/my-repo',
    origin: GitPearLink.normalize(`git+pear://${z32.encode(key)}/my-repo`),
    drive: {
      key,
      length: 0,
      fork: 0
    }
  })

  const res = GitPearLink.parse(url)

  t.is(res.drive.key.toString('hex'), key.toString('hex'))
  t.is(res.drive.length, 0)
  t.is(res.drive.fork, 0)
  t.is(res.pathname, '/my-repo')
})

test('link - serialize w/length', async (t) => {
  const key = b4a.alloc(32, 'test')

  const url = GitPearLink.serialize({
    protocol: 'git+pear:',
    pathname: '/my-repo',
    origin: GitPearLink.normalize(`git+pear://${z32.encode(key)}/my-repo`),
    drive: {
      key,
      length: 1,
      fork: 0
    }
  })

  const res = GitPearLink.parse(url)

  t.is(res.drive.key.toString('hex'), key.toString('hex'))
  t.is(res.drive.length, 1)
  t.is(res.drive.fork, 0)
  t.is(res.pathname, '/my-repo')
})
