// A harmless mod: one status line, nothing else.
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.ui.status('cwd: ' + (await $.session.cwd()))
    return next(e)
  })
}
