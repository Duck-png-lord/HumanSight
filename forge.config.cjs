module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: [
      "app.js",
      "index.html",
      "styles.css"
    ]
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "ImageTrainer",
        setupExe: "ImageTrainerSetup.exe"
      }
    }
  ]
};
