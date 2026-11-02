// An honest mod that runs a script from its own folder. Used to test the guard's hash check: edit helper.py while
// the session is open and the next run is denied.
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.after(10000, async () => {
      try {
        const r = await $.process.run(['python3', $.plugin.root + '/helper.py'])
        $.ui.log('date-mod: ' + r.stdout.trim(), { to: 'debug' })
      } catch (err) { $.ui.log('date-mod: ' + String(err && err.message || err), { to: 'debug' }) }
    })
    return next(e)
  })
}
