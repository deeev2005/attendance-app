import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'theme_manager.dart';
import 'screens/home_screen.dart';
import 'screens/profile_setup_screen.dart';
import 'screens/profile_screen.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'dart:io';

// Firebase packages
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';

// FCM and Location packages
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:geolocator/geolocator.dart';
import 'package:firebase_auth/firebase_auth.dart';

// Background message handler - MUST be top-level function
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  debugPrint('📩 Background message received: ${message.messageId}');
  debugPrint('📩 Data: ${message.data}');
  
  // Check if it's a location request
  if (message.data['type'] == 'location_request') {
    await _handleLocationRequest(message);
  }
}

// Function to get and send location
Future<void> _handleLocationRequest(RemoteMessage message) async {
  try {
    // Check permission
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied || 
        permission == LocationPermission.deniedForever) {
      debugPrint('❌ Location permission denied');
      return;
    }

    // Get current location
    Position position = await Geolocator.getCurrentPosition(
      desiredAccuracy: LocationAccuracy.high,
      timeLimit: const Duration(seconds: 10),
    );

    debugPrint('📍 Location obtained: ${position.latitude}, ${position.longitude}');

    // Get user UID
    String? uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null) {
      debugPrint('❌ No user logged in');
      return;
    }

    // Save to Firestore
    await FirebaseFirestore.instance
        .collection('locations')
        .add({
      'uid': uid,
      'latitude': position.latitude,
      'longitude': position.longitude,
      'accuracy': position.accuracy,
      'timestamp': FieldValue.serverTimestamp(),
      'messageId': message.messageId,
      'dataType': message.data['type'],
    });

    debugPrint('✅ Location saved to Firestore');
  } catch (e) {
    debugPrint('❌ Error getting location: $e');
  }
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Firebase
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  // Initialize FCM background handler
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

  // Request notification permission
  final messaging = FirebaseMessaging.instance;
  await messaging.requestPermission(
    alert: true,
    badge: true,
    sound: true,
  );

  // Get FCM token (print it for testing)
  String? token = await messaging.getToken();
  debugPrint('🔑 FCM Token: $token');

  runApp(
    ChangeNotifierProvider(
      create: (_) => ThemeManager(),
      child: const MyApp(),
    ),
  );
}

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  bool _loading = true;
  bool _hasProfile = false;

  @override
  void initState() {
    super.initState();
    _checkUserProfile();
    _setupFCM();
    _requestLocationPermission();
  }

  // Setup FCM for foreground messages
  void _setupFCM() {
    // Handle foreground messages
    FirebaseMessaging.onMessage.listen((RemoteMessage message) {
      debugPrint('📨 Foreground message received: ${message.data}');
      
      // Check if it's a location request
      if (message.data['type'] == 'location_request') {
        _handleLocationRequest(message);
      }
    });

    // Handle notification tap (when app is in background)
    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
      debugPrint('🔔 Notification tapped: ${message.messageId}');
    });
  }

  // Request location permission
  Future<void> _requestLocationPermission() async {
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    
    // Request "Allow all the time" for background location
    if (permission == LocationPermission.whileInUse) {
      debugPrint('⚠️ Consider requesting "Allow all the time" permission');
    }
  }

  Future<void> _checkUserProfile() async {
    try {
      // Get or create Firebase Auth user
      User? user = FirebaseAuth.instance.currentUser;
      
      if (user == null) {
        // Sign in anonymously if no user exists
        UserCredential userCredential = await FirebaseAuth.instance.signInAnonymously();
        user = userCredential.user;
      }

      if (user == null) {
        setState(() => _loading = false);
        return;
      }

      // Check if user profile exists
      var doc = await FirebaseFirestore.instance
          .collection('users')
          .doc(user.uid)
          .get();

      setState(() {
        _hasProfile = doc.exists;
        _loading = false;
      });
    } catch (e) {
      debugPrint('Error checking profile: $e');
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final themeManager = Provider.of<ThemeManager>(context);

    if (_loading) {
      return const MaterialApp(
        home: Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
      );
    }

    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Self Attendance',
      theme: ThemeData(
        brightness: Brightness.light,
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.indigo,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      themeMode: themeManager.themeMode,
      routes: {
        '/home': (_) => const HomeScreen(),
        '/profile': (_) => const ProfileSetupScreen(),
        '/view-profile': (_) => ProfileScreen(),
      },
      home: _hasProfile ? const HomeScreen() : const ProfileSetupScreen(),
    );
  }
}
