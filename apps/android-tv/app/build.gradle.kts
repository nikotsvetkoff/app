plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jlleitschuh.gradle.ktlint")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "com.example.iptv"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.example.iptv"
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  buildTypes {
    debug {
      buildConfigField("String", "API_BASE_URL", "\"http://10.0.2.2:3000\"")
    }
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro"
      )
      buildConfigField("String", "API_BASE_URL", "\"https://your-backend.example.com\"")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

    packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

dependencies {
  implementation(platform("androidx.compose:compose-bom:2024.11.00"))
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("androidx.tv:tv-material:1.0.0")

  implementation("androidx.media3:media3-exoplayer:1.5.1")
  implementation("androidx.media3:media3-ui:1.5.1")

  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

  debugImplementation("androidx.compose.ui:ui-tooling")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}
