// AI photo analysis -- the shared app's own serverless function, served
// from this app's /api/ (the shared page itself runs under /core/, where
// no function is deployed).
module.exports = require("../core/api/analyze-cage.js");
