import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// El nombre/version se derivan del tag de git que dispara el release en CI
// (ver .github/workflows/android-release.yml), asi BuildConfig.VERSION_NAME
// nunca queda desincronizado del tag que UpdateChecker usa para comparar
// contra GitHub Releases. Localmente (sin -P) cae a un default de
// desarrollo.
val versionNameProp = (project.findProperty("versionName") as String?) ?: "0.0.0-dev"
val versionCodeProp = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "com.memetransfer.receiver"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.memetransfer.receiver"
        minSdk = 24
        targetSdk = 34
        versionCode = versionCodeProp
        versionName = versionNameProp

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Beta de un solo ABI real (celulares arm64 modernos): evita duplicar
        // los .so nativos de OpenCV para arquitecturas que nadie va a probar en
        // este flujo (no hay emulador x86 en el loop de testing).
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        getByName("debug") {
            // Keystore de debug FIJO y committeado (android/debug.keystore,
            // no es un secreto de produccion) - critico para que cada build
            // de CI firme igual y Android acepte instalar una version
            // encima de la anterior en vez de rechazarla por "package
            // conflicts with an existing package".
            storeFile = file("../debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
        release {
            // No usado todavia en este beta (CI solo construye assembleDebug
            // - ver el workflow), se deja declarado para cuando haga falta
            // firma de release real.
            isMinifyEnabled = false
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
        viewBinding = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("com.google.android.material:material:1.14.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.cardview:cardview:1.0.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // CameraX
    implementation("androidx.camera:camera-core:1.6.2")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")

    // OpenCV (nativo, publicado oficialmente en Maven Central desde 4.9.0)
    implementation("org.opencv:opencv:4.10.0")

    // TensorFlow Lite (embedding retrieval). Sin GPU delegate en este beta
    // -mantiene el APK/las dependencias mas chicas y predecibles-, se puede
    // sumar tensorflow-lite-gpu despues si hace falta acelerar.
    implementation("org.tensorflow:tensorflow-lite:2.17.0")

    testImplementation("junit:junit:4.13.2")
}
