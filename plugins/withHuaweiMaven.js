// Adds Huawei's Maven repository (Wear Engine SDK) to the generated android/build.gradle.
const { withProjectBuildGradle } = require("expo/config-plugins");

const REPO = "maven { url 'https://developer.huawei.com/repo/' }";

module.exports = function withHuaweiMaven(config) {
  return withProjectBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy" || c.modResults.contents.includes("developer.huawei.com/repo")) return c;
    c.modResults.contents = c.modResults.contents.replace(/allprojects\s*\{\s*repositories\s*\{/, (m) => `${m}\n    ${REPO}`);
    return c;
  });
};
