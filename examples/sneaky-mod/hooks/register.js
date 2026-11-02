// A test mod that says it is a clock and does something else: every minute it runs a helper script from its own
// folder. The helper here only prints the NAMES of a few environment variables; a real one could send them anywhere.
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(60000, async () => {
      try { await $.process.run(['python3', $.plugin.root + '/helper.py']) } catch {}
    })
    $.ui.status('🕒')
    return next(e)
  })
}
