plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// 培养方案数据由仓库根的 data/curriculum 提供,构建时同步进 assets,不在 android/ 下再存一份副本。
// 与 src-tauri 引用 ../dist、../crates 是同一种仓库内依赖。
val curriculumAssetsDir = layout.buildDirectory.dir("generated/curriculumAssets")

val syncCurriculumAssets by tasks.registering(Copy::class) {
    from(File(rootProject.projectDir, "../data/curriculum")) {
        into("curriculum")
    }
    into(curriculumAssetsDir)
}

// 让资源合并任务等同步完成,否则 srcDir 只声明路径、不会触发拷贝。
tasks.configureEach {
    if (name.startsWith("merge") && name.endsWith("Assets")) {
        dependsOn(syncCurriculumAssets)
    }
}

// 固定的签名钥匙：同一把钥匙签出来的 APK 才能直接覆盖安装。之前 CI 每次用 runner 临时生成的
// 调试钥匙，每个包签名都不同，更新只能先卸载，本机的登录、手填学分和院系选择跟着丢。
// 钥匙不进仓库：CI 从 Secrets 解出来，本机放在 ~/.config/onepku/。都没有时退回默认调试钥匙。
val signingStore: File? = System.getenv("ONEPKU_KEYSTORE")?.let(::File)?.takeIf { it.isFile }
    ?: File(System.getProperty("user.home"), ".config/onepku/android-signing.jks").takeIf { it.isFile }
val signingPassword: String? = System.getenv("ONEPKU_KEYSTORE_PASSWORD")
    ?: File(System.getProperty("user.home"), ".config/onepku/android-signing.pass").takeIf { it.isFile }?.readText()?.trim()

android {
    namespace = "me.petertian.onepku"
    compileSdk = 35

    sourceSets.getByName("main").assets.srcDir(curriculumAssetsDir)

    defaultConfig {
        applicationId = "me.petertian.onepku"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.4.0"
    }

    signingConfigs {
        if (signingStore != null && signingPassword != null) {
            create("onepku") {
                storeFile = signingStore
                storePassword = signingPassword
                keyAlias = "onepku"
                keyPassword = signingPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            signingConfig = signingConfigs.findByName("onepku") ?: signingConfigs.getByName("debug")
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
            excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE", "META-INF/LICENSE.txt", "META-INF/NOTICE", "META-INF/NOTICE.txt")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    implementation(libs.hilt.android)
    ksp(libs.hilt.android.compiler)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.okhttp)
    implementation(libs.jsoup)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.exoplayer.hls)
    implementation(libs.androidx.media3.ui)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
