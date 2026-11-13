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
        authors: "Ducks_UK and Dennis :3",
        description: "Image Trainer desktop app for image training and local person detection.",
        setupExe: "ImageTrainerSetup.exe"
      }
    }
  ]
};
