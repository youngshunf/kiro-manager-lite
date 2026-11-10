// Actual app startup wrapper: isolate data and never replace installed protocol handlers.
const { app, dialog } = require('electron')
app.setAsDefaultProtocolClient = () => false
// The failure case verifies the message without opening a blocking native dialog.
if (process.env.KIRO_STARTUP_EXPECT_FAILURE === '1') {
  dialog.showErrorBox = (title, content) => console.error('EXPECTED_STARTUP_FAILURE', title, content)
}
require(process.argv[2])
