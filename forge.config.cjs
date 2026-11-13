module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: [
      "app.js",
      "client.js",
      "index.html",
      "styles.css"
    ]
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "ImageTrainer",
        authors: "Ducks_UK",
        description: "Image Trainer for image training and local person detection.",
        setupExe: "ImageTrainerSetup.exe"
      }
    }
  ]
};
