# Keep kotlinx.serialization generated serializers
-keepclasseswithmembers class **$$serializer { *; }
-keepclassmembers class * {
    @kotlinx.serialization.Serializable <init>(...);
}
-keep,includedescriptorclasses class *$$serializer { *; }

# Keep serializable models
-keep @kotlinx.serialization.Serializable class * { *; }

# Hilt
-keep class dagger.hilt.** { *; }
-dontwarn dagger.hilt.**

# OkHttp / OkIO
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Jsoup
-dontwarn org.jsoup.**
