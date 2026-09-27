// Adds Huawei's Maven repository (Wear Engine SDK) to the generated android/build.gradle.
const { withProjectBuildGradle } = require("expo/config-plugins");

// last in the list and limited to Huawei's groups, so other dependencies never wait on this server
const REPO = "maven { url 'https://developer.huawei.com/repo/'; content { includeGroupByRegex 'com\\\\.huawei.*' } }";

module.exports = function withHuaweiMaven(config) {
  return withProjectBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy" || c.modResults.contents.includes("developer.huawei.com/repo")) return c;
    const src = c.modResults.contents;
    const jitpack = "maven { url 'https://www.jitpack.io' }";
    c.modResults.contents = src.includes(jitpack)
      ? src.replace(jitpack, `${jitpack}\n    ${REPO}`)
      : src.replace(/allprojects\s*\{\s*repositories\s*\{/, (m) => `${m}\n    ${REPO}`);
    return c;
  });
};
