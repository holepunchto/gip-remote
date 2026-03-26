const { constructor: PearLink } = require('pear-link')

const protocol = 'git+pear:'

class GitPearLink extends PearLink {
  serialize(o) {
    if (o.protocol?.startsWith(protocol) === false) return super.serialize(o)
    o.protocol = o.protocol.slice(4)
    o.origin = o.origin.slice(4)
    return 'git+' + super.serialize(o)
  }
  parse(link) {
    if (link.startsWith(protocol) === false) return super.parse(link)
    const parsed = super.parse(link.slice(4))
    parsed.protocol = 'git+' + parsed.protocol
    parsed.origin = 'git+' + parsed.origin
    parsed.drive.length = parsed.drive.length ?? -1

    return parsed
  }
}

module.exports = new GitPearLink()
