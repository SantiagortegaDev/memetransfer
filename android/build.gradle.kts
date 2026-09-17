// Root build file: solo declara versiones de plugins, no aplica nada aca -
// el modulo :app es el unico modulo real de este proyecto (beta de un solo
// Activity, no hace falta multi-modulo todavia).
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
